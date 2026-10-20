// Shared helpers for the minions in Herdr. Used by the Herdr plugin (pair.mjs) and by the PR
// review hook (pr-review-handoff/hook.mjs).
//
// Roles come from pane labels: the pane labelled "builder-minion" writes the code, the pane
// labelled "reviewer-minion" reviews it. The tool in each pane is whatever Herdr detects there,
// so you can switch tools at any time. A workspace whose label ends in " minions" is a team: it
// also gets the other minions its project's .team/team.json names, and each minion starts with
// its role prompt. The minions themselves are files in team/minions/ (see minions.mjs).
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { CORE, REPO_ROOT, loadMinions, projectOf, readTeam, settingsOf, teamMembers, writePrompt } from './minions.mjs';

export { REPO_ROOT };
export const STATE_DIR = process.env.PR_HANDOFF_STATE_DIR || join(homedir(), '.local/state/pr-review-handoff');
// The command that starts a new conversation, so a reviewer never sees its earlier reviews.
export const CLEAR_COMMAND = { claude: '/clear', codex: '/new', cursor: '/clear', kiro: '/clear' };
const MINUTE = 60_000;
// Every minion, from its file, and the pane label of each: "qa" is "qa-minion".
const MINION_FILES = loadMinions();
export const MINIONS = Object.fromEntries(Object.keys(MINION_FILES).map((name) => [name, `${name}-minion`]));

// Panes for Guru, not for a minion: "guru" runs team watch, "log" shows the record. A seat never
// becomes a minion, and work started there gets no review.
export const SEATS = new Set(['guru', 'log']);

// The label of a project's team workspace, and whether a workspace label is one.
export const teamLabel = (dir) => `${basename(dir)} minions`;
export const isTeam = (label) => /\sminions$/.test(label ?? '');

// The running team workspace of a project folder, or null. Two projects with the same folder
// name have the same label, so the workspace must also have a pane in this folder. The caller's
// own workspace wins when two match.
export function findTeam(root) {
  const real = (dir) => { try { return realpathSync(dir); } catch { return dir; } };
  const home = real(root);
  const inHome = (pane) => pane.cwd && (real(pane.cwd) === home || real(pane.cwd).startsWith(`${home}/`));
  let named = [];
  try { named = herdr('workspace', 'list').workspaces.filter((w) => w.label === teamLabel(root)); } catch { return null; }
  const ours = named.filter((w) => {
    try { return herdr('pane', 'list', '--workspace', w.workspace_id).panes.some(inHome); } catch { return false; }
  });
  return ours.find((w) => w.workspace_id === process.env.HERDR_WORKSPACE_ID) ?? ours[0] ?? null;
}

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

// The settings for every project, from config.json at the repository root: they override the
// minion files' defaults (see settingsOf in minions.mjs). Empty when there is no config.json.
export function loadConfig(file = join(REPO_ROOT, 'config.json')) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; }
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

// The process IDs from pid up to the first process. Throws when ps cannot tell.
function ancestors(pid) {
  const found = new Set();
  for (let p = pid; p > 1 && !found.has(p);) {
    found.add(p);
    p = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(p)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
  }
  return found;
}

// Who runs this command: a minion's role, "guru", or null when that cannot be told. Any process
// can set HERDR_PANE_ID, so two signals are checked, and either one can make the caller a
// minion: the pane HERDR_PANE_ID names, and a minion pane whose shell is an ancestor of this
// process. A failure to tell gives null, so Guru's commands refuse. Only a process that is in no
// minion pane is Guru: in the guru pane, or in a terminal outside Herdr.
export function whoCalls() {
  const claimed = process.env.HERDR_PANE_ID;
  if (claimed) {
    try {
      const role = roleOf(herdr('pane', 'get', claimed).pane?.label);
      if (role) return role;
    } catch { return null; }
  }
  let mine;
  try { mine = ancestors(process.pid); } catch { return null; }
  let panes;
  try { panes = herdr('pane', 'list').panes; } catch { return process.env.HERDR_ENV === '1' ? null : 'guru'; }
  for (const pane of panes.filter((p) => roleOf(p.label))) {
    try {
      if (mine.has(herdr('pane', 'process-info', '--pane', pane.pane_id).process_info.shell_pid)) return roleOf(pane.label);
    } catch { return null; }
  }
  return 'guru';
}

// The tool to start in an empty reviewer pane: PR_REVIEWER if set, else the reviewer's tool,
// unless the builder already uses that tool; then the builder's configured tool.
// tools: { builder, reviewer }, the configured tool of each.
export function pickReviewer(builder, tools, env = {}) {
  if (env.PR_REVIEWER) return env.PR_REVIEWER;
  return tools.reviewer !== builder ? tools.reviewer : tools.builder;
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
// the pane labelled as the builder, else builderId when given (the pane that asked for a
// review), else a pane with an agent (the focused one first), else the focused pane, else the
// first. A labelled builder wins, so a workspace never gets two. The other roles come from
// labels only. Any of them can be null.
export function planLayout(panes, builderId = null) {
  // The builder is a pane with the builder role or with no role, and never a seat.
  const free = panes.filter((p) => !SEATS.has(p.label) && [null, 'builder'].includes(roleOf(p.label)));
  const builder = free.find((p) => roleOf(p.label) === 'builder')
    ?? free.find((p) => p.pane_id === builderId)
    ?? free.find((p) => p.agent && p.focused)
    ?? free.find((p) => p.agent)
    ?? free.find((p) => p.focused)
    ?? free[0] ?? null;
  const byLabel = (role) => {
    const found = panes.filter((p) => roleOf(p.label) === role);
    return found.find((p) => p.label === MINIONS[role]) ?? found[0] ?? null;
  };
  const others = Object.keys(MINIONS).filter((role) => role !== 'builder');
  return { builder, ...Object.fromEntries(others.map((role) => [role, byLabel(role)])) };
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

// The minions share one project folder, so only the builder may change it through git: a
// checkout by another minion would swap the builder's files under it.
// "git -C <dir>", "git -c <key>", "git --git-dir" and "git --work-tree" start with an option, so
// they are denied too.
const GIT_WRITES = ['git checkout', 'git switch', 'git stash', 'git reset', 'git restore', 'git commit', 'git merge',
  'git rebase', 'git pull', 'git push', 'git cherry-pick', 'git clean', 'git rm', 'git -C', 'git -c', 'git --git-dir',
  'git --work-tree', 'gh pr checkout']
  .map((c) => `Bash(${c}:*)`);
// The tools that take their role when they start. Any other tool gets roleNote with each message.
const ROLE_AT_START = new Set(['claude', 'codex']);

// The arguments that start a team minion with its role (the prompt file), its model and its
// effort. The role stays through /clear and /new. Claude reads the prompt file, may run `team`
// without asking, and, except for the builder, may not change the folder through git. Codex gets
// a one-line pointer to the file (Herdr refuses arguments with line breaks), and network access
// in its sandbox: without it, `team` cannot reach the Herdr socket. Cursor trusts the folder at
// once, because Herdr sees its trust question as idle and would type the first prompt into it.
export function roleArgs(role, kind, file, { model, effort } = {}) {
  if (kind === 'claude') {
    return ['--append-system-prompt-file', file, ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []),
      '--allowedTools', 'Bash(team:*)', ...(role === 'builder' ? [] : ['--disallowedTools', ...GIT_WRITES])];
  }
  if (kind === 'codex') {
    const pointer = `You are ${MINIONS[role]}, one of the minions. Before every task and every review, read ${file} and follow it.`;
    return [...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
      '-c', 'sandbox_mode="workspace-write"', '-c', 'sandbox_workspace_write.network_access=true',
      '-c', `developer_instructions=${JSON.stringify(pointer)}`];
  }
  if (kind === 'cursor') return ['--trust', ...(model ? ['--model', model] : [])];
  return [];
}

// The start of each message to a minion whose tool cannot take its role at start: a reminder of
// the role (the prompt file), which also works after /clear. Empty for Claude and Codex.
export function roleNote(role, kind, file) {
  return ROLE_AT_START.has(kind) ? '' : `(You are ${MINIONS[role]}, one of the minions: first read ${file} and follow it.) `;
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

// Whether the agent in the pane is ready for input now.
export const agentReady = (pane) => READY.has(herdr('agent', 'get', pane).agent.agent_status);

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

// Whether the process that took a lock has died, so the lock is left over. A lock with no
// owner file yet is still being taken.
function ownerGone(dir) {
  try {
    process.kill(Number(readFileSync(join(dir, 'owner'), 'utf8')), 0);
    return false;
  } catch (e) { return e.code === 'ESRCH'; }
}

// One run at a time per key. A lock is left over from a crash when its owner has died, or when
// it is older than staleMs. tryLock returns a release function, or null when another run holds
// the lock.
export function tryLock(key, staleMs = 10 * MINUTE) {
  const dir = join(STATE_DIR, 'locks', key);
  mkdirSync(join(STATE_DIR, 'locks'), { recursive: true });
  try { mkdirSync(dir); } catch {
    try {
      if (ownerGone(dir) || Date.now() - statSync(dir).mtimeMs > staleMs) rmSync(dir, { recursive: true, force: true });
    } catch { /* gone */ }
    try { mkdirSync(dir); } catch { return null; }
  }
  writeFileSync(join(dir, 'owner'), String(process.pid));
  return () => rmSync(dir, { recursive: true, force: true });
}

// Waits for the lock instead of giving up.
export async function withLock(key, work, staleMs = 180 * MINUTE) {
  let release;
  while (!(release = tryLock(key, staleMs))) await sleep(2000);
  try { return await work(); } finally { release(); }
}

// Makes sure the workspace has its minions, each with a tool running: the builder and the
// reviewer side by side, and in a team workspace also the other minions that its project's
// .team/team.json names, filling the two columns from the top. Safe to run many times: it only
// adds what is missing and never touches a running agent. Returns the pane ID of each minion
// and, in started, the minions it started a tool for; or null when another run is doing the work.
export async function ensureLayout(workspace, config = loadConfig(), builderId = null) {
  const release = tryLock(`layout-${workspace.replace(/[^A-Za-z0-9_-]/g, '-')}`);
  if (!release) return null;
  try {
    const label = herdr('workspace', 'get', workspace).workspace?.label;
    const panes = herdr('pane', 'list', '--workspace', workspace).panes;
    const found = planLayout(panes, builderId);
    if (!found.builder) return { builder: null, reviewer: found.reviewer?.pane_id ?? null, started: [] };
    const { builder } = found;
    // A team needs its project: the folder at or above the builder's with a .team/ folder.
    const root = isTeam(label) ? projectOf(builder.cwd ?? '') : null;
    if (isTeam(label) && !root) log(`layout ${workspace}: no .team/ at or above ${builder.cwd}, so only the pair starts`);
    const team = root ? readTeam(root) : null;
    const named = root ? teamMembers(team) : CORE;
    const unknown = named.filter((role) => !MINION_FILES[role]);
    if (unknown.length) log(`layout ${workspace}: .team/team.json names ${unknown.join(', ')}, which has no minion file; left out`);
    const members = named.filter((role) => MINION_FILES[role]);
    // Label before starting a tool: a tool's session hook reads the label when it starts.
    for (const role of members) {
      const pane = found[role];
      if (pane && pane.label !== MINIONS[role]) herdr('pane', 'rename', pane.pane_id, MINIONS[role]);
    }
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
      found.reviewer = split(builder, root ? 'right' : splitDirection(rect), 'reviewer');
    }
    // The other minions fill the columns from the top: left under the builder, right under the reviewer.
    const columns = [[builder], [found.reviewer]];
    members.slice(CORE.length).forEach((role, i) => {
      const column = columns[i % 2];
      found[role] ??= split(column.at(-1), 'down', role);
      column.push(found[role]);
    });
    const settings = Object.fromEntries(members.map((role) => [role, settingsOf(role, MINION_FILES, config, team)]));
    let builderTool = builder.agent ?? builder.agent_session?.agent;
    const started = [];
    for (const role of members) {
      const pane = found[role];
      if (!isFreeShell(pane)) continue;
      const tool = role === 'reviewer'
        ? pickReviewer(builderTool ?? settings.builder.tool, { builder: settings.builder.tool, reviewer: settings.reviewer.tool }, process.env)
        : settings[role].tool;
      if (role === 'builder') builderTool = tool;
      const args = root ? roleArgs(role, tool, writePrompt(root, role, MINION_FILES, members), settings[role]) : [];
      await startAgent(pane.pane_id, role, tool, args);
      started.push(role);
      log(`layout ${workspace}: started ${tool} in ${role} ${pane.pane_id}`);
    }
    return { ...Object.fromEntries(members.map((role) => [role, found[role].pane_id])), started };
  } finally { release(); }
}

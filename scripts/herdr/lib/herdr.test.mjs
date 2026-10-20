// Run: node --test lib/herdr.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const STATE = mkdtempSync(join(tmpdir(), 'pair-lib-'));
process.env.PR_HANDOFF_STATE_DIR = STATE;
process.env.HERDR_BIN_PATH = fileURLToPath(new URL('../test/fake-herdr.cjs', import.meta.url));
const lib = await import('./herdr.mjs');
const { agentName, ensureLayout, isTeam, loadConfig, pickReviewer, planLayout, roleArgs, roleNote, roleOf, splitDirection, teamLabel, tryLock } = lib;
const PAIR = fileURLToPath(new URL('../pair.mjs', import.meta.url));
const CONFIG = { builder: 'claude', reviewer: 'codex' };

test.after(() => rmSync(STATE, { recursive: true, force: true }));

// Points the fake herdr at a fresh state with these panes. Returns a reader for that state.
function fakeHerdr(t, panes, mode = 'ok', workspaces = []) {
  const file = join(mkdtempSync(join(tmpdir(), 'pair-herdr-')), 'herdr.json');
  t.after(() => rmSync(file, { force: true }));
  writeFileSync(file, JSON.stringify({ mode, current: panes[0]?.pane_id, panes, next: 2, calls: [], workspaces }));
  process.env.FAKE_HERDR_STATE = file;
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  const startCalls = () => read().calls.filter((a) => a[0] === 'agent' && a[1] === 'start');
  return {
    file,
    panes: () => read().panes,
    calls: () => read().calls,
    starts: () => startCalls().map((a) => [a[a.indexOf('--pane') + 1], a[a.indexOf('--kind') + 1]]),
    // The tool arguments of the agent started in a pane.
    argsOf: (pane) => { const a = startCalls().find((c) => c[c.indexOf('--pane') + 1] === pane); return a.slice(a.indexOf('--') + 1); },
  };
}

const shell = (id, extra = {}) => ({ pane_id: id, workspace_id: id.split(':')[0], tab_id: `${id.split(':')[0]}:t1`, cwd: '/repo', ...extra });
// What planLayout finds in a workspace with no product or QA pane.
const pair = (builder, reviewer) => ({ builder, reviewer, product: null, qa: null });

test('roleOf reads the pane label, including the old labels', () => {
  assert.equal(roleOf('builder-minion'), 'builder');
  assert.equal(roleOf('reviewer-minion'), 'reviewer');
  assert.equal(roleOf('coder'), 'builder');
  assert.equal(roleOf('reviewer'), 'reviewer');
  assert.equal(roleOf('codex review'), 'reviewer');
  assert.equal(roleOf('cursor review'), 'reviewer');
  assert.equal(roleOf('my notes'), null);
  assert.equal(roleOf(undefined), null);
});

test('pickReviewer uses the configured reviewer unless the coder already uses it', () => {
  assert.equal(pickReviewer('claude', CONFIG), 'codex');
  assert.equal(pickReviewer('kiro', CONFIG), 'codex');
  assert.equal(pickReviewer('codex', CONFIG), 'claude');
  assert.equal(pickReviewer('codex', CONFIG, { PR_REVIEWER: 'cursor' }), 'cursor');
});

test('planLayout picks the builder and reviewer panes', () => {
  const a = shell('w1:p1');
  const b = shell('w1:p2', { agent: 'kiro' });
  const c = shell('w1:p3', { focused: true });
  const r = shell('w1:p4', { label: 'cursor review' });
  assert.deepEqual(planLayout([a]), pair(a, null));
  // A pane with an agent beats the focused shell; the old reviewer label still counts.
  assert.deepEqual(planLayout([a, b, c, r]), pair(b, r));
  assert.deepEqual(planLayout([a, c]), pair(c, null));
  // The builder label wins, old or new, even over the pane that asked for a review: a workspace
  // must never get a second builder. Without a label, the caller's pane wins.
  const labelled = shell('w1:p5', { label: 'builder-minion' });
  assert.equal(planLayout([b, labelled]).builder, labelled);
  assert.equal(planLayout([b, shell('w1:p6', { label: 'coder' })]).builder.pane_id, 'w1:p6');
  assert.equal(planLayout([b, labelled], 'w1:p9').builder, labelled);
  assert.equal(planLayout([a, b, labelled], 'w1:p1').builder, labelled);
  assert.equal(planLayout([a, b], 'w1:p1').builder, a);
  // Guru's seats never become a minion, even when they ask for a review.
  const guru = shell('w1:p8', { label: 'guru', focused: true });
  assert.equal(planLayout([guru, b], 'w1:p8').builder, b);
  assert.equal(planLayout([guru, shell('w1:p9', { label: 'log' })]).builder, null);
  // The new reviewer label beats an old one.
  const minion = shell('w1:p7', { label: 'reviewer-minion' });
  assert.equal(planLayout([a, r, minion]).reviewer, minion);
  // Only a reviewer pane: no builder.
  assert.deepEqual(planLayout([r]), pair(null, r));
});

test('agentName is a valid, unique Herdr name', () => {
  assert.equal(agentName('reviewer-minion', 'wW:p3'), 'reviewer-minion-ww-p3');
  assert.match(agentName('builder-minion', 'w123456789:p123456789'), /^[a-z][a-z0-9_-]{0,31}$/);
  assert.notEqual(agentName('reviewer-minion', 'w1:p3'), agentName('reviewer-minion', 'w1:p4'));
  // Long pane IDs still fit whole.
  assert.equal(agentName('reviewer-minion', 'w1234:p123'), 'reviewer-minion-w1234-p123');
});

test('splitDirection splits wide panes right and tall panes down', () => {
  assert.equal(splitDirection({ width: 123, height: 33 }), 'right');
  assert.equal(splitDirection({ width: 60, height: 40 }), 'down');
  assert.equal(splitDirection(undefined), 'down');
});

test('loadConfig reads config.json, and is empty without one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pair-config-'));
  writeFileSync(join(dir, 'config.json'), '{"builder":"kiro"}');
  assert.deepEqual(loadConfig(join(dir, 'config.json')), { builder: 'kiro' });
  assert.deepEqual(loadConfig(join(dir, 'missing.json')), {});
  rmSync(dir, { recursive: true });
});

test('tryLock lets one run in and frees the lock on release', () => {
  const release = tryLock('test-lock');
  assert.ok(release);
  assert.equal(tryLock('test-lock'), null);
  release();
  const again = tryLock('test-lock');
  assert.ok(again);
  again();
});

test('a new workspace gets a reviewer pane to the right, and both tools start', async t => {
  const herdr = fakeHerdr(t, [shell('w1:p1')]);
  assert.deepEqual(await ensureLayout('w1', CONFIG), { builder: 'w1:p1', reviewer: 'w1:p2', started: ['builder', 'reviewer'] });
  const [builder, reviewer] = herdr.panes();
  assert.equal(builder.label, 'builder-minion');
  assert.equal(reviewer.label, 'reviewer-minion');
  assert.equal(reviewer.cwd, '/repo');
  const split = herdr.calls().find((a) => a[0] === 'pane' && a[1] === 'split');
  assert.ok(split.includes('right') && split.includes('--no-focus'));
  assert.deepEqual(herdr.starts(), [['w1:p1', 'claude'], ['w1:p2', 'codex']]);
  // The panes are labelled before any tool starts in them.
  const calls = herdr.calls().map((a) => a.slice(0, 2).join(' '));
  assert.ok(calls.lastIndexOf('pane rename') < calls.indexOf('agent start'));
});

test('a complete workspace is left alone', async t => {
  const herdr = fakeHerdr(t, [shell('w1:p1', { label: 'builder-minion', agent: 'kiro' }), shell('w1:p2', { label: 'reviewer-minion', agent: 'cursor' })]);
  await ensureLayout('w1', CONFIG);
  assert.deepEqual(herdr.calls().map((a) => a.slice(0, 2).join(' ')).filter((c) => c !== 'pane process-info'), ['workspace get', 'pane list']);
});

test('the old coder and reviewer labels get the minion labels, and the agents keep running', async t => {
  const herdr = fakeHerdr(t, [shell('w1:p1', { label: 'coder', agent: 'claude' }), shell('w1:p2', { label: 'reviewer', agent: 'codex' })]);
  await ensureLayout('w1', CONFIG);
  assert.deepEqual(herdr.panes().map((p) => p.label), ['builder-minion', 'reviewer-minion']);
  assert.deepEqual(herdr.starts(), []);
});

test('an existing workspace keeps its running agents and gets the missing reviewer', async t => {
  // codex already runs as the builder, so the reviewer is claude.
  const herdr = fakeHerdr(t, [shell('w1:p1', { agent: 'codex', agent_session: { value: 's' } })]);
  await ensureLayout('w1', CONFIG);
  assert.deepEqual(herdr.starts(), [['w1:p2', 'claude']]);
  assert.equal(herdr.panes()[0].label, 'builder-minion');
});

test('an old "<tool> review" pane is renamed, and a pane waiting to resume is not touched', async t => {
  const herdr = fakeHerdr(t, [shell('w1:p1', { agent_session: { agent: 'claude', value: 's' } }), shell('w1:p3', { label: 'cursor review' })]);
  await ensureLayout('w1', CONFIG);
  assert.equal(herdr.panes()[1].label, 'reviewer-minion');
  assert.ok(!herdr.calls().some((a) => a[1] === 'split'));
  // The builder pane resumes claude on its own; only the empty reviewer gets a tool.
  assert.deepEqual(herdr.starts(), [['w1:p3', 'codex']]);
});

test('a pane busy with another program gets no agent', async t => {
  const herdr = fakeHerdr(t, [shell('w1:p1', { label: 'builder-minion' }), shell('w1:p2', { label: 'reviewer-minion' })], 'busy');
  await ensureLayout('w1', CONFIG);
  assert.deepEqual(herdr.starts(), []);
});

// A project folder with a .team/ folder and, when given, a .team/team.json.
function project(t, team = null) {
  const root = mkdtempSync(join(tmpdir(), 'pair-project-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.team'));
  if (team) writeFileSync(join(root, '.team', 'team.json'), JSON.stringify(team));
  return root;
}

test('a team workspace with no team.json gets four minions in a 2x2 grid, each with its role', async t => {
  const root = project(t);
  const herdr = fakeHerdr(t, [shell('w1:p1', { cwd: root })], 'ok', [{ workspace_id: 'w1', label: 'app minions' }]);
  assert.deepEqual(await ensureLayout('w1', CONFIG), { builder: 'w1:p1', reviewer: 'w1:p2', product: 'w1:p3', qa: 'w1:p4', started: ['builder', 'reviewer', 'product', 'qa'] });
  assert.deepEqual(herdr.panes().map((p) => p.label), ['builder-minion', 'reviewer-minion', 'product-minion', 'qa-minion']);
  // Reviewer to the right of the builder; product below the builder; QA below the reviewer.
  const splits = herdr.calls().filter((a) => a[1] === 'split').map((a) => [a[a.indexOf('--pane') + 1], a[a.indexOf('--direction') + 1]]);
  assert.deepEqual(splits, [['w1:p1', 'right'], ['w1:p1', 'down'], ['w1:p2', 'down']]);
  assert.deepEqual(herdr.starts(), [['w1:p1', 'claude'], ['w1:p2', 'codex'], ['w1:p3', 'claude'], ['w1:p4', 'claude']]);
  // Each minion starts with its own role, saved in .team/prompts/, and its model and effort.
  assert.deepEqual(herdr.argsOf('w1:p3').slice(0, 6), ['--append-system-prompt-file', join(root, '.team', 'prompts', 'product.md'), '--model', 'sonnet', '--effort', 'medium']);
  assert.match(readFileSync(join(root, '.team', 'prompts', 'product.md'), 'utf8'), /product-minion: "the user's advocate"/);
  assert.match(herdr.argsOf('w1:p2').join(' '), /developer_instructions=.*reviewer-minion/);
  // Every pane has its label before the first tool starts.
  const calls = herdr.calls().map((a) => a.slice(0, 2).join(' '));
  assert.ok(calls.lastIndexOf('pane rename') < calls.indexOf('agent start'));
});

test('a team.json picks the minions, and its settings beat config.json', async t => {
  const root = project(t, { minions: { builder: {}, reviewer: { tool: 'cursor' }, qa: { model: 'opus' } } });
  const herdr = fakeHerdr(t, [shell('w1:p1', { cwd: root })], 'ok', [{ workspace_id: 'w1', label: 'app minions' }]);
  assert.deepEqual(await ensureLayout('w1', { qa: { model: 'haiku', effort: 'low' } }),
    { builder: 'w1:p1', reviewer: 'w1:p2', qa: 'w1:p3', started: ['builder', 'reviewer', 'qa'] });
  // The first other minion goes under the builder.
  const splits = herdr.calls().filter((a) => a[1] === 'split').map((a) => [a[a.indexOf('--pane') + 1], a[a.indexOf('--direction') + 1]]);
  assert.deepEqual(splits, [['w1:p1', 'right'], ['w1:p1', 'down']]);
  assert.deepEqual(herdr.starts(), [['w1:p1', 'claude'], ['w1:p2', 'cursor'], ['w1:p3', 'claude']]);
  // team.json's model beats config.json's; config.json's effort fills what team.json leaves out.
  assert.deepEqual(herdr.argsOf('w1:p3').slice(2, 6), ['--model', 'opus', '--effort', 'low']);
  // QA's prompt lists only this team, and says what the team does without a product-minion.
  const prompt = readFileSync(join(root, '.team', 'prompts', 'qa.md'), 'utf8');
  assert.match(prompt, /## This team\n- \*\*builder-minion\*\*: .*\n- \*\*reviewer-minion\*\*: .*\n- \*\*qa-minion\*\*: /);
  assert.match(prompt, /This team has no product-minion: builder-minion takes its tasks/);
  assert.doesNotMatch(prompt, /This team has no qa-minion/);
});

test('a team workspace with no .team/ folder gets only the pair', async t => {
  const herdr = fakeHerdr(t, [shell('w1:p1', { cwd: tmpdir() })], 'ok', [{ workspace_id: 'w1', label: 'app minions' }]);
  assert.deepEqual(await ensureLayout('w1', CONFIG), { builder: 'w1:p1', reviewer: 'w1:p2', started: ['builder', 'reviewer'] });
  assert.deepEqual(herdr.argsOf('w1:p1').slice(-2), ['--timeout', '60000']);
});

test('a pair workspace starts its tools without role arguments', async t => {
  const herdr = fakeHerdr(t, [shell('w1:p1')], 'ok', [{ workspace_id: 'w1', label: 'app' }]);
  await ensureLayout('w1', CONFIG);
  assert.deepEqual(herdr.argsOf('w1:p1'), ['agent', 'start', 'builder-minion-w1-p1', '--kind', 'claude', '--pane', 'w1:p1', '--timeout', '60000']);
});

test('team labels and role arguments', () => {
  assert.equal(teamLabel('/code/my-app'), 'my-app minions');
  assert.equal(isTeam('my-app minions'), true);
  assert.equal(isTeam('minions'), false);
  assert.equal(isTeam('my-app'), false);
  assert.deepEqual(roleArgs('builder', 'claude', '/x/builder.md'), ['--append-system-prompt-file', '/x/builder.md', '--allowedTools', 'Bash(team:*)']);
  // The minions share one folder: only the builder may switch branches or commit.
  const qa = roleArgs('qa', 'claude', '/x/qa.md');
  assert.deepEqual(qa.slice(0, 5), ['--append-system-prompt-file', '/x/qa.md', '--allowedTools', 'Bash(team:*)', '--disallowedTools']);
  for (const command of ['git checkout', 'git push', 'git clean', 'git rm', 'git -C', 'git -c', 'git --git-dir', 'git --work-tree', 'gh pr checkout']) {
    assert.ok(qa.includes(`Bash(${command}:*)`), command);
  }
  const codex = roleArgs('reviewer', 'codex', '/x/reviewer.md');
  assert.ok(codex.includes('sandbox_workspace_write.network_access=true'));
  assert.ok(codex.includes('developer_instructions="You are reviewer-minion, one of the minions. Before every task and every review, read /x/reviewer.md and follow it."'));
  // Herdr refuses arguments with line breaks.
  assert.ok(codex.every((a) => !a.includes('\n')));
  assert.deepEqual(roleArgs('qa', 'kiro', '/x/qa.md'), []);
  assert.deepEqual(roleArgs('reviewer', 'cursor', '/x/reviewer.md'), ['--trust']);
  // Each tool gets the model and effort in its own way.
  assert.deepEqual(roleArgs('reviewer', 'cursor', '/x/r.md', { model: 'gpt-5' }), ['--trust', '--model', 'gpt-5']);
  assert.deepEqual(roleArgs('reviewer', 'codex', '/x/r.md', { model: 'o3', effort: 'high' }).slice(0, 4), ['-m', 'o3', '-c', 'model_reasoning_effort="high"']);
});

test('roleNote reminds a tool that cannot take its role at start', () => {
  assert.equal(roleNote('reviewer', 'claude', '/x/r.md'), '');
  assert.equal(roleNote('reviewer', 'codex', '/x/r.md'), '');
  assert.equal(roleNote('reviewer', 'cursor', '/x/r.md'), '(You are reviewer-minion, one of the minions: first read /x/r.md and follow it.) ');
});

test('a second run at the same time does nothing', async t => {
  const herdr = fakeHerdr(t, [shell('w1:p1')]);
  const release = tryLock('layout-w1');
  assert.equal(await ensureLayout('w1', CONFIG), null);
  release();
  assert.deepEqual(herdr.calls(), []);
});

test('pair.mjs reads the workspace from the Herdr event', t => {
  const herdr = fakeHerdr(t, [shell('w7:p1')]);
  const event = JSON.stringify({ event: 'workspace_created', data: { type: 'workspace_created', workspace: { workspace_id: 'w7' } } });
  const run = spawnSync(process.execPath, [PAIR], { encoding: 'utf8', timeout: 30000, env: { ...process.env, HERDR_PLUGIN_EVENT_JSON: event } });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(herdr.panes().map((p) => p.label), ['builder-minion', 'reviewer-minion']);
  // workspace.focused events carry only the ID.
  const focused = fakeHerdr(t, [shell('w8:p1', { label: 'builder-minion', agent: 'claude' }), shell('w8:p2', { label: 'reviewer-minion', agent: 'codex' })]);
  const run2 = spawnSync(process.execPath, [PAIR], { encoding: 'utf8', timeout: 30000, env: { ...process.env, HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ event: 'workspace_focused', data: { type: 'workspace_focused', workspace_id: 'w8' } }) } });
  assert.equal(run2.status, 0, run2.stderr);
  assert.deepEqual(focused.calls()[0], ['workspace', 'get', 'w8']);
});

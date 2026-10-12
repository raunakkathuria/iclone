// Run: node --test lib/herdr.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const STATE = mkdtempSync(join(tmpdir(), 'pair-lib-'));
process.env.PR_HANDOFF_STATE_DIR = STATE;
process.env.HERDR_BIN_PATH = fileURLToPath(new URL('../test/fake-herdr.cjs', import.meta.url));
const lib = await import('./herdr.mjs');
const { agentName, ensureLayout, loadConfig, pickReviewer, planLayout, roleOf, splitDirection, tryLock } = lib;
const PAIR = fileURLToPath(new URL('../pair.mjs', import.meta.url));
const CONFIG = { coder: 'claude', reviewer: 'codex' };

test.after(() => rmSync(STATE, { recursive: true, force: true }));

// Points the fake herdr at a fresh state with these panes. Returns a reader for that state.
function fakeHerdr(t, panes, mode = 'ok') {
  const file = join(mkdtempSync(join(tmpdir(), 'pair-herdr-')), 'herdr.json');
  t.after(() => rmSync(file, { force: true }));
  writeFileSync(file, JSON.stringify({ mode, current: panes[0]?.pane_id, panes, next: 2, calls: [] }));
  process.env.FAKE_HERDR_STATE = file;
  const read = () => JSON.parse(readFileSync(file, 'utf8'));
  return {
    file,
    panes: () => read().panes,
    calls: () => read().calls,
    starts: () => read().calls.filter((a) => a[0] === 'agent' && a[1] === 'start').map((a) => [a[a.indexOf('--pane') + 1], a[a.indexOf('--kind') + 1]]),
  };
}

const shell = (id, extra = {}) => ({ pane_id: id, workspace_id: id.split(':')[0], tab_id: `${id.split(':')[0]}:t1`, cwd: '/repo', ...extra });

test('roleOf reads the pane label, including the old hook labels', () => {
  assert.equal(roleOf('coder'), 'coder');
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

test('planLayout picks the coder and reviewer panes', () => {
  const a = shell('w1:p1');
  const b = shell('w1:p2', { agent: 'kiro' });
  const c = shell('w1:p3', { focused: true });
  const r = shell('w1:p4', { label: 'cursor review' });
  assert.deepEqual(planLayout([a]), { coder: a, reviewer: null });
  // A pane with an agent beats the focused shell; the old reviewer label still counts.
  assert.deepEqual(planLayout([a, b, c, r]), { coder: b, reviewer: r });
  assert.deepEqual(planLayout([a, c]), { coder: c, reviewer: null });
  // The coder label wins, and the caller's pane wins over everything.
  const labelled = shell('w1:p5', { label: 'coder' });
  assert.equal(planLayout([b, labelled]).coder, labelled);
  assert.equal(planLayout([b, labelled], 'w1:p9').coder, labelled);
  assert.equal(planLayout([a, b, labelled], 'w1:p1').coder, a);
  // Only a reviewer pane: no coder.
  assert.deepEqual(planLayout([r]), { coder: null, reviewer: r });
});

test('agentName is a valid, unique Herdr name', () => {
  assert.equal(agentName('reviewer', 'wW:p3'), 'reviewer-ww-p3');
  assert.match(agentName('coder', 'w123456789:p123456789'), /^[a-z][a-z0-9_-]{0,31}$/);
  assert.notEqual(agentName('reviewer', 'w1:p3'), agentName('reviewer', 'w1:p4'));
});

test('splitDirection splits wide panes right and tall panes down', () => {
  assert.equal(splitDirection({ width: 123, height: 33 }), 'right');
  assert.equal(splitDirection({ width: 60, height: 40 }), 'down');
  assert.equal(splitDirection(undefined), 'down');
});

test('loadConfig reads config.json and falls back to claude and codex', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pair-config-'));
  writeFileSync(join(dir, 'config.json'), '{"coder":"kiro"}');
  assert.deepEqual(loadConfig(join(dir, 'config.json')), { coder: 'kiro', reviewer: 'codex' });
  assert.deepEqual(loadConfig(join(dir, 'missing.json')), CONFIG);
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
  assert.deepEqual(await ensureLayout('w1', CONFIG), { coder: 'w1:p1', reviewer: 'w1:p2' });
  const [coder, reviewer] = herdr.panes();
  assert.equal(coder.label, 'coder');
  assert.equal(reviewer.label, 'reviewer');
  assert.equal(reviewer.cwd, '/repo');
  const split = herdr.calls().find((a) => a[0] === 'pane' && a[1] === 'split');
  assert.ok(split.includes('right') && split.includes('--no-focus'));
  assert.deepEqual(herdr.starts(), [['w1:p1', 'claude'], ['w1:p2', 'codex']]);
});

test('a complete workspace is left alone', async t => {
  const herdr = fakeHerdr(t, [shell('w1:p1', { label: 'coder', agent: 'kiro' }), shell('w1:p2', { label: 'reviewer', agent: 'cursor' })]);
  await ensureLayout('w1', CONFIG);
  assert.deepEqual(herdr.calls().map((a) => a.slice(0, 2).join(' ')).filter((c) => c !== 'pane process-info'), ['pane list']);
});

test('an existing workspace keeps its running agents and gets the missing reviewer', async t => {
  // codex already runs as the coder, so the reviewer is claude.
  const herdr = fakeHerdr(t, [shell('w1:p1', { agent: 'codex', agent_session: { value: 's' } })]);
  await ensureLayout('w1', CONFIG);
  assert.deepEqual(herdr.starts(), [['w1:p2', 'claude']]);
  assert.equal(herdr.panes()[0].label, 'coder');
});

test('an old "<tool> review" pane is renamed, and a pane waiting to resume is not touched', async t => {
  const herdr = fakeHerdr(t, [shell('w1:p1', { agent_session: { agent: 'claude', value: 's' } }), shell('w1:p3', { label: 'cursor review' })]);
  await ensureLayout('w1', CONFIG);
  assert.equal(herdr.panes()[1].label, 'reviewer');
  assert.ok(!herdr.calls().some((a) => a[1] === 'split'));
  // The coder pane resumes claude on its own; only the empty reviewer gets a tool.
  assert.deepEqual(herdr.starts(), [['w1:p3', 'codex']]);
});

test('a pane busy with another program gets no agent', async t => {
  const herdr = fakeHerdr(t, [shell('w1:p1', { label: 'coder' }), shell('w1:p2', { label: 'reviewer' })], 'busy');
  await ensureLayout('w1', CONFIG);
  assert.deepEqual(herdr.starts(), []);
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
  assert.deepEqual(herdr.panes().map((p) => p.label), ['coder', 'reviewer']);
  // workspace.focused events carry only the ID.
  const focused = fakeHerdr(t, [shell('w8:p1', { label: 'coder', agent: 'claude' }), shell('w8:p2', { label: 'reviewer', agent: 'codex' })]);
  const run2 = spawnSync(process.execPath, [PAIR], { encoding: 'utf8', timeout: 30000, env: { ...process.env, HERDR_PLUGIN_EVENT_JSON: JSON.stringify({ event: 'workspace_focused', data: { type: 'workspace_focused', workspace_id: 'w8' } }) } });
  assert.equal(run2.status, 0, run2.stderr);
  assert.deepEqual(focused.calls()[0], ['pane', 'list', '--workspace', 'w8']);
});

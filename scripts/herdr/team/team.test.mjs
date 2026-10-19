// Run: node --test team/team.test.mjs
// Runs team-up and team against the fake herdr, in a throwaway project folder.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const TEAM_UP = fileURLToPath(new URL('./team-up.mjs', import.meta.url));
const TEAM = fileURLToPath(new URL('./team.mjs', import.meta.url));
const FAKE_HERDR = fileURLToPath(new URL('../test/fake-herdr.cjs', import.meta.url));

const dir = mkdtempSync(join(tmpdir(), 'team-'));
const project = join(dir, 'my-app');
const herdrState = join(dir, 'herdr.json');
mkdirSync(project);
writeFileSync(herdrState, JSON.stringify({ mode: 'ok', panes: [], next: 1, calls: [], workspaces: [] }));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const state = () => JSON.parse(readFileSync(herdrState, 'utf8'));
const setState = (change) => writeFileSync(herdrState, JSON.stringify({ ...state(), ...change }));
const teamFile = (name) => readFileSync(join(project, '.team', name), 'utf8');
const prompts = (pane) => state().calls.filter((a) => a[0] === 'agent' && a[1] === 'prompt' && a[2] === pane).map((a) => a[3]);
const paneOf = (label) => state().panes.find((p) => p.label === label)?.pane_id;

function run(script, args = [], cwd = project) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, HERDR_BIN_PATH: FAKE_HERDR, FAKE_HERDR_STATE: herdrState, PR_HANDOFF_STATE_DIR: join(dir, 'state'), HERDR_WORKSPACE_ID: '' },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
}

// The tests run in order: each one builds on the team the one before left behind.
test('team-up first creates .team/ and asks Gru for the goal', () => {
  const { code, out } = run(TEAM_UP);
  assert.equal(code, 0);
  assert.match(out, /Write the goal in \.team\/GOAL\.md/);
  for (const name of ['GOAL.md', 'BOARD.md', 'DECISIONS.md', 'ESCALATIONS.md', 'LESSONS.md']) assert.ok(teamFile(name));
  assert.equal(teamFile('.gitignore'), 'LOG.md\n');
  // No minion starts before there is a goal.
  assert.deepEqual(state().calls, []);
});

test('with a goal, team-up starts four minions in a "<project> minions" workspace', () => {
  writeFileSync(join(project, '.team', 'GOAL.md'), '# GOAL\nShip the thing.\n');
  const { code, err } = run(TEAM_UP);
  assert.equal(code, 0, err);
  assert.deepEqual(state().workspaces.map((w) => w.label), ['my-app minions']);
  assert.deepEqual(state().panes.map((p) => [p.label, p.agent]),
    [['builder-minion', 'claude'], ['reviewer-minion', 'codex'], ['product-minion', 'claude'], ['qa-minion', 'claude']]);
  // Each minion gets its first prompt; the goal check goes to product and reviewer.
  assert.match(prompts(paneOf('reviewer-minion'))[0], /goal check/);
  assert.match(prompts(paneOf('product-minion'))[0], /goal check/);
  assert.match(prompts(paneOf('qa-minion'))[0], /wait for a handover/);
  assert.equal(teamFile('GOAL.md'), '# GOAL\nShip the thing.\n');
});

test('a second team-up finds the running team and starts nothing', () => {
  const before = state().calls.filter((a) => a[1] === 'start').length;
  const { code, out } = run(TEAM_UP);
  assert.equal(code, 0);
  assert.match(out, /already running/);
  assert.equal(state().workspaces.length, 1);
  assert.equal(state().calls.filter((a) => a[1] === 'start').length, before);
});

test('team say from Gru reaches the minion and is logged', () => {
  const { code, out } = run(TEAM, ['say', 'reviewer', 'is', 'REST', 'fine?'], join(project, '.team'));
  assert.equal(code, 0);
  assert.match(out, /sent to reviewer-minion/);
  assert.equal(prompts(paneOf('reviewer-minion')).at(-1), '[from gru] is REST fine?');
  assert.match(teamFile('LOG.md'), /gru -> reviewer-minion: is REST fine\?/);
});

test('team say from a minion names it and says how to reply', () => {
  setState({ current: paneOf('qa-minion') });
  run(TEAM, ['say', 'builder-minion', 'T-1 fails']);
  assert.equal(prompts(paneOf('builder-minion')).at(-1), '[from qa-minion] T-1 fails (to reply: team say qa "...")');
  setState({ current: null });
  assert.equal(run(TEAM, ['say', 'gru', 'hi']).code, 1);
  assert.equal(run(TEAM, ['say', 'qa']).code, 1);
});

test('escalate and decide: Gru is told, and every minion hears the decision', () => {
  const escalated = run(TEAM, ['escalate', 'REST or GraphQL']);
  assert.match(escalated.out, /^E-1\. Fill in \.team\/handoffs\/E-1\.md/);
  assert.match(teamFile('ESCALATIONS.md'), /## E-1 \(.*, raised by gru\) OPEN\nTopic: REST or GraphQL/);
  assert.ok(existsSync(join(project, '.team', 'handoffs', 'E-1.md')));
  assert.ok(state().calls.some((a) => a[0] === 'notification' && a.includes('my-app E-1: REST or GraphQL')));

  assert.equal(run(TEAM, ['decide', 'E-1', 'REST', 'more than 1000 requests a second']).out.trim(), 'D-1');
  assert.match(teamFile('DECISIONS.md'), /## D-1 \(.*, Gru, resolves E-1\)\nDecision: REST\nRevisit if: more than 1000 requests a second/);
  assert.match(teamFile('ESCALATIONS.md'), /## E-1 .* CLOSED by D-1/);
  for (const label of ['builder-minion', 'reviewer-minion', 'product-minion', 'qa-minion']) {
    assert.match(prompts(paneOf(label)).at(-1), /^Gru decided D-1 \(resolves E-1\): REST\./);
  }
  // An escalation is decided once.
  assert.equal(run(TEAM, ['decide', 'E-1', 'GraphQL']).code, 1);
  assert.equal(run(TEAM, ['escalate', 'next one']).out.slice(0, 4), 'E-2.');
});

test('team status shows the board, open escalations and decisions', () => {
  const { out } = run(TEAM, ['status']);
  assert.match(out, /# BOARD/);
  assert.match(out, /## E-2 .* OPEN/);
  assert.match(out, /## D-1/);
});

test('team down closes the team workspace', () => {
  assert.equal(run(TEAM, ['down']).code, 0);
  assert.deepEqual(state().workspaces, []);
  assert.match(run(TEAM, ['say', 'qa', 'hi']).err, /not running/);
});

test('team needs a .team/ folder and a known command', () => {
  assert.match(run(TEAM, ['status'], dir).err, /no \.team\/ folder/);
  assert.equal(run(TEAM, ['dance']).code, 1);
  assert.match(run(TEAM, []).err, /Usage:/);
});

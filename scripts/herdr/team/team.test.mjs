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
  // A minion in a tool that cannot take its role at start gets a reminder with each message.
  setState({ panes: state().panes.map((p) => (p.label === 'reviewer-minion' ? { ...p, agent: 'cursor' } : p)) });
  run(TEAM, ['say', 'reviewer', 'plan ready']);
  assert.match(prompts(paneOf('reviewer-minion')).at(-1), /^\[from gru\] \(You are reviewer-minion, one of the minions: first read \S+reviewer\.md and follow it\.\) plan ready$/);
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

const TEMPLATE_LESSONS = readFileSync(new URL('./templates/LESSONS.md', import.meta.url), 'utf8');
const range = (n) => Array.from({ length: n }, (_, i) => i + 1);
const setLessons = (text) => writeFileSync(join(project, '.team', 'LESSONS.md'), text);
// The template with these lesson numbers under Lessons, and these lines under Watching.
const lessonsFile = (numbers, watching = []) => TEMPLATE_LESSONS
  .replace('## Lessons\n', () => `## Lessons\n\n${numbers.map((n) => `L-${n} Rule ${n}. Why: PR #${n}.\n`).join('')}`)
  .replace(/## Watching.*\n/, (heading) => `${heading}\n${watching.map((w) => `${w}\n`).join('')}`);

// Runs team learn, and checks that it failed and left LESSONS.md and LOG.md as they were.
function refused(...args) {
  const before = [teamFile('LESSONS.md'), teamFile('LOG.md')];
  const result = run(TEAM, ['learn', ...args]);
  assert.equal(result.code, 1);
  assert.deepEqual([teamFile('LESSONS.md'), teamFile('LOG.md')], before);
  return result.err;
}

test('team learn adds the next lesson last in Lessons, and logs who added it', () => {
  const before = lessonsFile([1, 20], ['W-1 Watch 1. Why: PR #1.']);
  setLessons(before);
  const log = teamFile('LOG.md');
  setState({ current: paneOf('reviewer-minion') });
  const { code, out } = run(TEAM, ['learn', 'x', '--from', 'y']);
  setState({ current: null });
  assert.equal(code, 0);
  // The next number comes after the highest one, not after the count.
  assert.equal(out.trim(), 'L-21');
  assert.equal(teamFile('LESSONS.md'), before.replace('PR #20.\n', 'PR #20.\nL-21 x. Why: y.\n'));
  assert.match(teamFile('LOG.md').slice(log.length), /^[\d-]+ [\d:]+ reviewer-minion learned L-21: x\. Why: y\.\n$/);
});

test('team learn refuses a 16th lesson, and Watching lines do not count', () => {
  setLessons(lessonsFile(range(15)));
  assert.match(refused('x', '--from', 'y'), /has 15 lessons.*Merge two lessons or drop one/);
  // A lesson under another heading above Watching counts too.
  setLessons(lessonsFile(range(14)).replace('## Watching', '## Merged\nL-15 Rule 15. Why: PR #15.\n\n## Watching'));
  assert.match(refused('x', '--from', 'y'), /has 15 lessons/);
  setLessons(lessonsFile(range(14), range(10).map((n) => `W-${n} Watch ${n}. Why: PR #${n}.`)));
  assert.equal(run(TEAM, ['learn', 'x', '--from', 'y']).out.trim(), 'L-15');
});

test('team learn starts at L-1, adds no second ".", and keeps quotes and $ as they are', () => {
  setLessons(TEMPLATE_LESSONS);
  // The example "L-1" in the rules at the top of the template is not a lesson.
  assert.equal(run(TEAM, ['learn', 'Quote "it" and $HOME.', '--from', "PR #3's $1"]).out.trim(), 'L-1');
  assert.equal(teamFile('LESSONS.md'), TEMPLATE_LESSONS.replace('## Lessons\n', () => `## Lessons\n\nL-1 Quote "it" and $HOME. Why: PR #3's $1.\n`));
});

test('team learn refuses bad input, and a file with no Lessons heading', () => {
  const bad = [[], ['x'], ['x', '--from'], ['', '--from', 'y'], ['  ', '--from', 'y'], ['x', '--from', ''],
    ['x', '--from', 'y', 'z'], ['x', '--form', 'y'], ['x\n## Watching', '--from', 'y'], ['x', '--from', 'y\r']];
  for (const args of bad) assert.match(refused(...args), /usage: team learn <rule> --from <source>/, JSON.stringify(args));
  // "Why:" may appear only once in a lesson line, between the rule and the source.
  for (const args of [['a Why: b', '--from', 'y'], ['Why: a', '--from', 'y'], ['Ask Why:', '--from', 'y'], ['x', '--from', 'Why: PR #3']]) {
    assert.match(refused(...args), /cannot contain "Why:"/, JSON.stringify(args));
  }
  setLessons('# LESSONS\n\n## Watching\n');
  assert.match(refused('x', '--from', 'y'), /has no "## Lessons" heading/);
  setLessons(TEMPLATE_LESSONS);
});

test('team learn W-n moves that line from Watching to the end of Lessons', () => {
  const before = lessonsFile([1, 4], ['W-12 r. Why: s.', 'W-1 a. Why: b.', 'W-2 c. Why: d.']);
  setLessons(before);
  const log = teamFile('LOG.md');
  const { code, out } = run(TEAM, ['learn', 'W-1']);
  assert.equal(code, 0);
  assert.equal(out.trim(), 'L-5');
  // Only W-1 moves, not W-12.
  assert.equal(teamFile('LESSONS.md'), before.replace('PR #4.\n', 'PR #4.\nL-5 a. Why: b.\n').replace('W-1 a. Why: b.\n', ''));
  assert.match(teamFile('LOG.md').slice(log.length), /^[\d-]+ [\d:]+ gru learned L-5 from W-1: a\. Why: b\.\n$/);
});

test('team learn W-n refuses a full list, a missing W-n, and a line without one "Why:"', () => {
  setLessons(lessonsFile(range(15), ['W-1 a. Why: b.']));
  assert.match(refused('W-1'), /has 15 lessons.*Merge two lessons or drop one/);
  setLessons(lessonsFile([1], ['W-1 a. Why: b.', 'W-2 no reason.', 'W-3 a. Why: b. Why: c.']));
  assert.match(refused('W-9'), /has no W-9 under "## Watching"/);
  for (const id of ['W-2', 'W-3']) assert.match(refused(id), new RegExp(`has ${id}, which must have exactly one "Why:"`));
  setLessons('# LESSONS\n\n## Lessons\n');
  assert.match(refused('W-1'), /has no W-1 under "## Watching"/);
  setLessons(TEMPLATE_LESSONS);
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

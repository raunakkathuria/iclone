// Run: node --test team/watch.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardTasks, openEscalations, render, wrap } from './watch.mjs';

const plain = (lines) => lines.map((line) => line.replace(/\x1b\[[0-9;]*m/g, ''));
const view = (change) => plain(render({
  escalations: [], tasks: [['T-1', 'DONE'], ['T-2', 'DOING']], lastLog: '13:12 qa-minion -> builder-minion: T-1 PASS',
  idleMinutes: 0, time: '21:16', width: 60, rows: 6, ...change,
}));

test('openEscalations and boardTasks read the record files', () => {
  const escalations = '# ESCALATIONS\n\n## E-1 (x, raised by guru) CLOSED by D-1\nTopic: old\n\n## E-2 (x, raised by qa-minion) OPEN\nTopic: REST or GraphQL\n';
  assert.deepEqual(openEscalations(escalations), ['E-2: REST or GraphQL']);
  const board = '| ID | Task | Owner | Status | Criteria |\n|----|---|---|---|---|\n| T-1 | learn | builder-minion | DONE | x |\n| T-2 | promote | builder-minion | QA | y |\n';
  assert.deepEqual(boardTasks(board), [['T-1', 'DONE'], ['T-2', 'QA']]);
});

test('wrap breaks at spaces, and cuts a word longer than the line', () => {
  assert.deepEqual(wrap('one two three', 7), ['one two', 'three']);
  assert.deepEqual(wrap('abcdefghij', 4), ['abcd', 'efgh', 'ij']);
});

test('the first line says whether Guru needs to act', () => {
  assert.deepEqual(view({}), ['Nothing needs you. 21:16', 'T-1 DONE  T-2 DOING', '13:12 qa-minion -> builder-minion: T-1 PASS']);
  const asked = view({ escalations: ['E-2: REST or GraphQL'] });
  assert.deepEqual(asked.slice(0, 3), ['Guru, a decision is needed:', 'E-2: REST or GraphQL', 'Answer: team decide E-n <decision> --revisit <when>']);
  assert.match(render({ escalations: ['E-2: x'], tasks: [], lastLog: '', idleMinutes: 0, time: '', width: 60, rows: 6 })[0], /^\x1b\[1;31m/);
});

test('a team idle for 5 minutes with open tasks gets a warning', () => {
  assert.equal(view({ idleMinutes: 4 }).length, 3);
  assert.match(view({ idleMinutes: 5 }).join(' '), /Nothing needs you\. 21:16 Every minion has been idle for 5 minutes, but T-2 is not DONE\. Nudge one/);
  assert.equal(view({ idleMinutes: 9, tasks: [['T-1', 'DONE']] }).length, 3);
  assert.equal(view({ idleMinutes: null })[1], 'The team is not running. Start it with team-up.');
});

test('the view wraps the last message and fits the pane', () => {
  const lines = view({ lastLog: `13:12 qa-minion -> product-minion: ${'word '.repeat(30)}`, rows: 4 });
  assert.equal(lines.length, 4);
  assert.ok(lines.every((line) => line.length <= 60));
});

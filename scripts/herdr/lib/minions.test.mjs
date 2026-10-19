// Run: node --test lib/minions.test.mjs
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadMinions, parseMinion, projectOf, settingsOf, teamMembers } from './minions.mjs';

test('parseMinion reads the top block and keeps the rest as the role', () => {
  const minion = parseMinion('---\ntool: claude\nmodel:\njob: Tests it: all of it.\n---\n# qa-minion\nRole text.\n');
  assert.deepEqual(minion, { role: '# qa-minion\nRole text.\n', tool: 'claude', job: 'Tests it: all of it.' });
  assert.deepEqual(parseMinion('# no top block\n'), { role: '# no top block\n' });
});

test('loadMinions puts the pair first, then the others by name, and skips _rules.md', t => {
  const folder = mkdtempSync(join(tmpdir(), 'minions-'));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  for (const name of ['security', 'reviewer', '_rules', 'builder', 'docs']) writeFileSync(join(folder, `${name}.md`), `---\njob: ${name}\n---\n`);
  assert.deepEqual(Object.keys(loadMinions(folder)), ['builder', 'reviewer', 'docs', 'security']);
  // The minion files that ship with this kit.
  assert.deepEqual(Object.keys(loadMinions()), ['builder', 'reviewer', 'product', 'qa']);
});

test('teamMembers is the pair plus the minions team.json names, or the default ones', () => {
  assert.deepEqual(teamMembers(null), ['builder', 'reviewer', 'product', 'qa']);
  assert.deepEqual(teamMembers({ minions: { qa: {}, builder: {} } }), ['builder', 'reviewer', 'qa']);
  assert.deepEqual(teamMembers({ minions: {} }), ['builder', 'reviewer']);
});

test('settingsOf layers the minion file, config.json and team.json', () => {
  const minions = { qa: { tool: 'claude', model: 'sonnet', effort: 'medium' }, docs: {} };
  assert.deepEqual(settingsOf('qa', minions), { tool: 'claude', model: 'sonnet', effort: 'medium' });
  // A config value can be just a tool name.
  assert.deepEqual(settingsOf('qa', minions, { qa: 'cursor' }), { tool: 'cursor', model: 'sonnet', effort: 'medium' });
  assert.deepEqual(settingsOf('qa', minions, { qa: { effort: 'low' } }, { minions: { qa: { model: 'opus' } } }),
    { tool: 'claude', model: 'opus', effort: 'low' });
  // A minion file with no tool runs on Claude.
  assert.equal(settingsOf('docs', minions).tool, 'claude');
});

test('projectOf finds the nearest folder with a .team/ folder', t => {
  const root = mkdtempSync(join(tmpdir(), 'project-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.team'));
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  assert.equal(projectOf(join(root, 'src', 'deep')), root);
  assert.equal(projectOf(root), root);
  assert.equal(projectOf(tmpdir()), null);
});

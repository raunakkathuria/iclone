// Run: node --test lib/git.test.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const STATE = mkdtempSync(join(tmpdir(), 'git-state-'));
process.env.PR_HANDOFF_STATE_DIR = STATE;
const { EMPTY_TREE, changedBetween, currentBranch, firstBase, lastReviewed, markReviewed, reviewBase, snapshot } = await import('./git.mjs');
test.after(() => rmSync(STATE, { recursive: true, force: true }));

// A repository with one commit on its default branch. Returns it and a git runner.
function repo(t) {
  const root = mkdtempSync(join(tmpdir(), 'git-repo-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');
  writeFileSync(join(root, 'a.txt'), 'one\n');
  writeFileSync(join(root, '.gitignore'), 'secret.txt\n');
  git('add', '.');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'first');
  const commit = (message) => git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qam', message);
  return { root, git, commit };
}

test('a snapshot holds new files but not ignored ones, and leaves the index alone', t => {
  const { root, git } = repo(t);
  const clean = snapshot(root);
  assert.equal(clean, git('rev-parse', 'HEAD^{tree}'));
  writeFileSync(join(root, 'new.txt'), 'new\n');
  writeFileSync(join(root, 'secret.txt'), 'ignored\n');
  const tree = snapshot(root);
  assert.deepEqual(git('ls-tree', '--name-only', tree).split('\n'), ['.gitignore', 'a.txt', 'new.txt']);
  // The project's own index still knows nothing about new.txt.
  assert.equal(git('status', '--porcelain'), '?? new.txt');
  // The same work gives the same snapshot.
  assert.equal(snapshot(root), tree);
});

test('changedBetween ignores .team/', t => {
  const { root } = repo(t);
  const before = snapshot(root);
  mkdirSync(join(root, '.team'));
  writeFileSync(join(root, '.team', 'BOARD.md'), '| T-1 | DOING |\n');
  assert.equal(changedBetween(root, before, snapshot(root)), false);
  writeFileSync(join(root, 'a.txt'), 'two\n');
  assert.equal(changedBetween(root, before, snapshot(root)), true);
});

test('firstBase: where the branch left the remote, else the local main, else the last commit, else everything', t => {
  const { root, git, commit } = repo(t);
  const main = currentBranch(root);
  // One commit on the default branch, no remote: everything.
  assert.equal(firstBase(root), EMPTY_TREE);
  writeFileSync(join(root, 'a.txt'), 'two\n');
  commit('second');
  // Two commits, no remote: the last commit and the work not committed.
  assert.equal(firstBase(root), git('rev-parse', 'HEAD~1'));
  // On main, a local master is not a base: it is the other name for the default branch.
  const other = main === 'main' ? 'master' : 'main';
  git('branch', other, 'HEAD~1');
  writeFileSync(join(root, 'a.txt'), 'two and a half\n');
  commit('two and a half');
  assert.equal(firstBase(root), git('rev-parse', 'HEAD~1'));
  git('branch', '-D', other);
  // Another branch, no remote: where it left the local default branch.
  const fork = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(join(root, 'a.txt'), 'three\n');
  commit('third');
  assert.ok(['main', 'master'].includes(main));
  assert.equal(firstBase(root, 'feature'), fork);
  // With a remote: where the branch left it.
  const first = git('rev-list', '--max-parents=0', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', first);
  assert.equal(firstBase(root, 'feature'), first);
});

test('a finished review is remembered per branch, and the next one starts there', t => {
  const { root, git } = repo(t);
  assert.equal(lastReviewed(root), null);
  assert.equal(reviewBase(root), EMPTY_TREE);
  writeFileSync(join(root, 'a.txt'), 'two\n');
  const tree = snapshot(root);
  markReviewed(root, tree);
  assert.equal(lastReviewed(root), tree);
  assert.equal(reviewBase(root), tree);
  // A reference keeps the snapshot, so git's clean-up never deletes it.
  assert.equal(git('rev-parse', `refs/herdr/reviewed/${currentBranch(root)}`), tree);
  git('gc', '--quiet', '--prune=now');
  assert.equal(lastReviewed(root), tree);
  // Another branch has its own memory.
  git('checkout', '-q', '-b', 'other');
  assert.equal(lastReviewed(root), null);
  // A snapshot git does not have is never recorded.
  assert.throws(() => markReviewed(root, 'f'.repeat(40)));
  assert.equal(lastReviewed(root), null);
});
